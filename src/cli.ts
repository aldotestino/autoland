#!/usr/bin/env bun
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Runtime } from "effect";
import { Command } from "effect/cli";
import { Otlp, OtlpSerialization } from "effect/observability";
import packageJson from "../package.json";
import { runBatch } from "./batch";
import { UsageError } from "./domain";
import { GitHub } from "./github";
import { Agent } from "./opencode";
import { params } from "./params";
import { Repair } from "./repair";
import { Tty } from "./tty";
import { Ui } from "./ui";

const mergePrs = Command.make(
  "autoland",
  params,
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
