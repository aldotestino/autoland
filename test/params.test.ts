import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import { params } from "../src/params";

const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

const parse = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed: Array<{
      readonly prs: ReadonlyArray<string>;
      readonly dryRun: boolean;
      readonly yes: boolean;
      readonly nonInteractive: boolean;
    }> = [];
    const command = Command.make("autoland", params, ({ dryRun, nonInteractive, prs, yes }) =>
      Effect.sync(() => {
        parsed.push({ dryRun, nonInteractive, prs, yes });
      }),
    );
    yield* Command.runWith(command, { version: "0.0.0", renderErrors: false })(args);
    return parsed[0];
  }).pipe(Effect.provide(CliTestLayer));

describe("boolean flags", () => {
  it.effect.each(["--dry-run", "--yes", "--non-interactive"])(
    "%s leaves PR numbers 1 and 0 as positionals",
    (flag) =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* parse([flag, "1", "2"]))?.prs, ["1", "2"]);
        assert.deepStrictEqual((yield* parse([flag, "0", "2"]))?.prs, ["0", "2"]);
      }),
  );

  it.effect("--dry-run stays on when followed by a number that reads as false", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* parse(["--dry-run", "0", "2"]))?.dryRun);
    }),
  );

  it.effect("are off by default and on when given", () =>
    Effect.gen(function* () {
      const off = yield* parse(["2"]);
      assert.deepStrictEqual([off?.dryRun, off?.yes, off?.nonInteractive], [false, false, false]);
      const on = yield* parse(["--dry-run", "--yes", "--non-interactive", "2"]);
      assert.deepStrictEqual([on?.dryRun, on?.yes, on?.nonInteractive], [true, true, true]);
    }),
  );

  it.effect("can still be set explicitly with =", () =>
    Effect.gen(function* () {
      assert.isFalse((yield* parse(["--dry-run=false", "2"]))?.dryRun);
      assert.isTrue((yield* parse(["--dry-run=true", "2"]))?.dryRun);
    }),
  );
});
