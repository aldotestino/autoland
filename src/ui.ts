import { Context, Effect, Fiber, Layer, Stdio, Stream } from "effect";
import { TerminalCapabilities } from "effect/cli";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CLEAR_LINE = "\r\u001b[2K";

const tint = (code: number, text: string) => `\u001b[${code}m${text}\u001b[0m`;

/**
 * All program output, plus the single-line status: a spinner on a terminal that
 * becomes a ✓ or ✗ when it finishes, or plain lines when output is redirected.
 *
 * Everything goes through one writer so that lines and spinner frames stay in order.
 */
export class Ui extends Context.Service<
  Ui,
  {
    readonly log: (text: string) => Effect.Effect<void>;
    readonly error: (text: string) => Effect.Effect<void>;
    /** The running status, or `""` when there is none. */
    readonly current: Effect.Effect<string>;
    /** Starting the running status again is a no-op; any other replaces it as failed. */
    readonly start: (text: string) => Effect.Effect<void>;
    /** Stops the status and prints `text`, which defaults to the running status. */
    readonly finish: (success: boolean, text?: string) => Effect.Effect<void>;
    /** Hides the spinner while `effect` uses the terminal, then brings it back. */
    readonly pausing: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("autoland/Ui") {
  static readonly layer = Layer.effect(
    Ui,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const { canAnimate, canColor } = yield* TerminalCapabilities.TerminalCapabilities;
      const scope = yield* Effect.scope;

      // Output failures, such as a closed pipe, must not change what the batch does.
      const write = (text: string) =>
        Stream.make(text).pipe(Stream.run(stdio.stdout()), Effect.ignore);
      const writeError = (text: string) =>
        Stream.make(text).pipe(Stream.run(stdio.stderr()), Effect.ignore);

      let current = "";
      let spinner: Fiber.Fiber<unknown> | undefined;

      const stopSpinner = Effect.suspend(() => {
        if (spinner === undefined) return Effect.void;
        const running = spinner;
        spinner = undefined;
        return Fiber.interrupt(running).pipe(Effect.andThen(write(CLEAR_LINE)));
      });

      const spin = (text: string) =>
        Effect.suspend(() =>
          // A pause inside a pause must not leave a second spinner running.
          spinner !== undefined
            ? Effect.void
            : animate(text).pipe(
                Effect.forkIn(scope),
                Effect.map((fiber) => {
                  spinner = fiber;
                }),
              ),
        );

      const pausing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        stopSpinner.pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            Effect.suspend(() => (canAnimate && current !== "" ? spin(current) : Effect.void)),
          ),
        );

      const finish = (success: boolean, text?: string) =>
        Effect.gen(function* () {
          const line = text ?? current;
          yield* stopSpinner;
          current = "";
          if (line === "") return;
          const mark = success ? "✓" : "✗";
          const shown = canColor ? tint(success ? 32 : 31, mark) : mark;
          yield* write(`${shown} ${line}\n`);
        });

      const animate = (text: string) =>
        Effect.gen(function* () {
          for (let index = 0; ; index = (index + 1) % FRAMES.length) {
            const frame = FRAMES[index] ?? "";
            yield* write(`${CLEAR_LINE}${canColor ? tint(36, frame) : frame} ${text}`);
            yield* Effect.sleep("100 millis");
          }
        });

      const start = (text: string) =>
        Effect.gen(function* () {
          if (current === text) return;
          if (current !== "") yield* finish(false, `${current} (restarted).`);
          current = text;
          if (canAnimate) {
            yield* spin(text);
          } else {
            yield* write(`… ${text}\n`);
          }
        });

      return Ui.of({
        // Through `pausing`, or the text would land on the end of the spinner's line.
        log: (text) => pausing(write(`${text}\n`)),
        error: (text) => pausing(writeError(`${text}\n`)),
        current: Effect.sync(() => current),
        start,
        finish,
        pausing,
      });
    }),
  );
}
