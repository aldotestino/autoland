import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type ReplySignal, settledElsewhere } from "../src/opencode";

/** Whether the effect has finished once everything that can run has run. */
const settles = (effect: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("1 hour");
    const settled = fiber.pollUnsafe() !== undefined;
    yield* Fiber.interrupt(fiber);
    return settled;
  });

const signals = (...items: ReadonlyArray<ReplySignal>) => Stream.make(...items);

describe("settledElsewhere", () => {
  it.effect("settles when the reply arrives", () =>
    Effect.gen(function* () {
      const settled = yield* settles(
        settledElsewhere(signals("connected", "other", "replied"), Effect.succeed(true)),
      );
      assert.isTrue(settled);
    }),
  );

  it.effect("settles when the request was answered before connecting", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* settles(settledElsewhere(signals("connected"), Effect.succeed(false))));
    }),
  );

  it.effect("keeps waiting while the request is pending and other events arrive", () =>
    Effect.gen(function* () {
      const settled = yield* settles(
        settledElsewhere(signals("connected", "other", "other"), Effect.succeed(true)),
      );
      assert.isFalse(settled);
    }),
  );

  it.effect("does not take the prompt away when the stream ends or fails", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* settles(settledElsewhere(Stream.empty, Effect.succeed(false))));
      assert.isFalse(
        yield* settles(settledElsewhere(Stream.fail("dropped"), Effect.succeed(false))),
      );
    }),
  );

  it.effect("does not take the prompt away when the pending check fails", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* settles(settledElsewhere(signals("connected"), Effect.fail("500"))));
    }),
  );
});
