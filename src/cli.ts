#!/usr/bin/env bun
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Runtime, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Otlp, OtlpSerialization } from "effect/observability";
import packageJson from "../package.json";
import { runBatch } from "./batch";
import { MergeMethod, UsageError } from "./domain";
import { GitHub } from "./github";
import { Agent } from "./opencode";
import { Repair } from "./repair";
import { Tty } from "./tty";
import { Ui } from "./ui";

const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((label: string) => !label.startsWith("--") || "Label must not be an option"),
  Schema.makeFilter(
    (label: string) => !label.includes(",") || "Pass each label with a separate --label option",
  ),
);

const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999 }));

const mergePrs = Command.make(
  "autoland",
  {
    prs: Argument.String("pr").pipe(
      Argument.withDescription(
        "PR numbers, #numbers, or pull request URLs, separated by spaces, commas, or newlines",
      ),
      Argument.variadic(),
    ),
    method: Flag.Literals("method", MergeMethod.literals).pipe(
      Flag.withDescription("Merge method (default: squash)"),
      Flag.withDefault("squash"),
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Maximum wait per PR, in seconds (default: 1800)"),
      Flag.withSchema(Timeout),
      Flag.withDefault(1800),
    ),
    labels: Flag.String("label").pipe(
      Flag.withDescription("Require this label (repeatable; all must match)"),
      Flag.withSchema(Label),
      Flag.atLeast(0),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Read-only preview; no updates, merges, or repairs"),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Skip the initial batch confirmation"),
      Flag.withDefault(false),
    ),
    nonInteractive: Flag.Boolean("non-interactive").pipe(
      Flag.withDescription("Skip all prompts and leave conflicts unmerged"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("autoland")(function* ({ dryRun, labels, method, nonInteractive, prs, timeout, yes }) {
    yield* runBatch({
      inputs: prs,
      method,
      timeoutSeconds: timeout,
      labels,
      dryRun,
      yes: yes || nonInteractive,
      interactive: !nonInteractive,
    }).pipe(
      Effect.provide(
        Repair.layer.pipe(
          Layer.provide(Agent.layer),
          Layer.provideMerge(Tty.layer({ interactive: !nonInteractive })),
          Layer.provideMerge(Ui.layer),
          Layer.merge(GitHub.layer),
          Layer.provide(BunHttpClient.layer),
        ),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Update, approve if needed, and merge a batch of pull requests in order, one at a time. " +
      "Run from the target repository. Branch protections are never bypassed.",
  ),
  Command.withExamples([
    { command: "autoland --dry-run 125 123 124", description: "Preview a batch" },
    { command: "printf '125, 123\\n124\\n' | autoland", description: "Read the list from stdin" },
    { command: "autoland --label ok-to-merge --label agent", description: "Merge by labels" },
    { command: "autoland", description: "Choose from a list of open PRs" },
  ]),
);

const Observability = Otlp.layerFromConfig({
  resource: {
    serviceName: "autoland",
  },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(BunHttpClient.layer));

// `runMain` treats both signals as an interruption, which exits with 130.
let terminated = false;
process.once("SIGTERM", () => {
  terminated = true;
});

mergePrs.pipe(
  Command.run({ version: packageJson.version }),
  // Help has already been rendered. Invalid input keeps the documented status.
  Effect.catchTag("ShowHelp", (error) =>
    error.errors.length === 0
      ? Effect.void
      : Effect.fail(new UsageError({ message: "Invalid command line" })),
  ),
  Effect.provide(Layer.merge(BunServices.layer, Observability)),
  (program) =>
    BunRuntime.runMain(program, {
      teardown: (exit, onExit) =>
        Runtime.defaultTeardown(exit, (code) => onExit(terminated && code === 130 ? 143 : code)),
    }),
);
