import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stdio } from "effect";
import { TerminalCapabilities } from "effect/cli";
import { TestClock } from "effect/testing";
import { Ui } from "../src/ui";

const CLEAR_LINE = "\r\u001b[2K";

const withUi = <A, E>(run: (output: Array<string>) => Effect.Effect<A, E, Ui>) => {
  const output: Array<string> = [];
  const capture = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      output.push(String(chunk));
    }),
  );
  return run(output).pipe(
    Effect.provide(
      Ui.layer.pipe(
        Layer.provide(
          Layer.succeed(TerminalCapabilities.TerminalCapabilities, {
            canAnimate: true,
            canColor: false,
            canPrompt: true,
          }),
        ),
        Layer.provide(Stdio.layerTest({ stdout: () => capture, stderr: () => capture })),
      ),
    ),
  );
};

/** Each text printed by a line of `text` must start on a line of its own. */
const assertOnOwnLine = (output: ReadonlyArray<string>, text: string) => {
  const index = output.findIndex((chunk) => chunk.includes(text));
  assert.isAtLeast(index, 1);
  assert.strictEqual(output[index - 1], CLEAR_LINE);
};

describe("Ui", () => {
  it.effect("clears the spinner's line before printing, then brings the spinner back", () =>
    withUi((output) =>
      Effect.gen(function* () {
        const ui = yield* Ui;
        yield* ui.start("working");
        yield* TestClock.adjust("100 millis");

        yield* ui.log("to stdout");
        assertOnOwnLine(output, "to stdout");
        yield* TestClock.adjust("100 millis");
        yield* ui.error("to stderr");
        assertOnOwnLine(output, "to stderr");

        const framesBefore = output.length;
        yield* TestClock.adjust("100 millis");
        assert.isAbove(output.length, framesBefore);
        assert.include(output.at(-1) ?? "", "working");
        yield* ui.finish(true);
      }),
    ),
  );

  it.effect("runs one spinner after nested pauses", () =>
    withUi((output) =>
      Effect.gen(function* () {
        const ui = yield* Ui;
        yield* ui.start("working");
        yield* TestClock.adjust("100 millis");
        yield* ui.pausing(ui.log("nested"));
        yield* TestClock.adjust("100 millis");

        const before = output.length;
        yield* TestClock.adjust("100 millis");
        assert.strictEqual(output.length, before + 1);
        yield* ui.finish(true);

        const finished = output.length;
        yield* TestClock.adjust("1 second");
        assert.strictEqual(output.length, finished);
      }),
    ),
  );
});
