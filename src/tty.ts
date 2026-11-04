// Raw terminal access has no Effect equivalent: this file is the boundary for it.
// oxlint-disable effecttsgo/node-builtin-import
import * as Fs from "node:fs";
import * as Readline from "node:readline";
import { PassThrough } from "node:stream";
import * as NodeTty from "node:tty";
import {
  type Cause,
  Config,
  Context,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  PlatformError,
  Queue,
  type Scope,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { Prompt } from "effect/cli";

const ENTER_FULLSCREEN = "\u001b[?1049h\u001b[?25l\u001b[?7l";
const LEAVE_FULLSCREEN = "\u001b[?7h\u001b[?25h\u001b[?1049l";

/**
 * The controlling terminal. Prompts use `/dev/tty` rather than stdin so that a
 * PR list piped into stdin does not consume the answers to them.
 */
export class Tty extends Context.Service<
  Tty,
  {
    /** False with `--non-interactive`, or when there is no controlling terminal. */
    readonly available: boolean;
    /** Runs a prompt, or returns none when no terminal is available. Quitting interrupts. */
    readonly prompt: <A>(
      prompt: Prompt.Prompt<A>,
      options?: { readonly fullscreen?: boolean },
    ) => Effect.Effect<Option.Option<A>>;
    /** Sends a Ghostty desktop notification; a no-op in other terminals. */
    readonly notify: (title: string, body: string) => Effect.Effect<void>;
  }
>()("autoland/Tty") {
  static readonly layer = (options: { readonly interactive: boolean }) =>
    Layer.effect(
      Tty,
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio;
        const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
        const termProgram = yield* Config.option(Config.String("TERM_PROGRAM")).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        const available = options.interactive && canOpenTty();

        const prompt: Context.Service.Shape<typeof Tty>["prompt"] = (self, promptOptions) => {
          if (!available) return Effect.succeed(Option.none());
          return Effect.gen(function* () {
            const terminal = yield* openTerminal;
            if (promptOptions?.fullscreen) {
              yield* Effect.acquireRelease(Effect.orDie(terminal.display(ENTER_FULLSCREEN)), () =>
                Effect.ignore(terminal.display(LEAVE_FULLSCREEN)),
              );
            }
            return yield* Prompt.run(self).pipe(
              Effect.provideService(Terminal.Terminal, terminal),
              Effect.provideContext(platform),
              Effect.map(Option.some),
            );
          }).pipe(
            Effect.scoped,
            Effect.catchTags({
              QuitError: () => Effect.interrupt,
              PlatformError: (cause) => Effect.die(cause),
            }),
          );
        };

        const notify: Context.Service.Shape<typeof Tty>["notify"] = (title, body) =>
          Effect.gen(function* () {
            if (Option.getOrUndefined(termProgram) !== "ghostty") return;
            const sequence = `\u001b]777;notify;${title};${body}\u0007`;
            if (available) {
              yield* Effect.scoped(
                openTerminal.pipe(Effect.flatMap((terminal) => terminal.display(sequence))),
              );
            } else if (yield* stdio.stderrIsTerminal) {
              yield* Stream.make(sequence).pipe(Stream.run(stdio.stderr()));
            }
          }).pipe(Effect.ignore);

        return Tty.of({ available, prompt, notify });
      }),
    );
}

const canOpenTty = (): boolean => {
  try {
    Fs.closeSync(Fs.openSync("/dev/tty", "r+"));
    return true;
  } catch {
    return false;
  }
};

const platformError = (method: string, cause: unknown): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: "Tty", method, cause });

// Not Esc: ending the queue would beat the key to a prompt that treats it as an answer.
const shouldQuit = (key: Terminal.Key): boolean =>
  key.ctrl && (key.name === "c" || key.name === "d");

const KEY_POLL_INTERVAL = "15 millis";

const isWouldBlock = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EAGAIN";

/**
 * A `Terminal` over freshly opened `/dev/tty` descriptors, closed with the scope.
 *
 * Input is polled from a non-blocking descriptor. A blocking read, which is what
 * Bun's `tty.ReadStream` does, cannot be cancelled: it would stay pending after
 * the prompt, swallow the next keypress, and keep the process alive at exit. It
 * would also compete with anything else reading the terminal, such as ssh asking
 * for a passphrase.
 */
const openTerminal: Effect.Effect<Terminal.Terminal, PlatformError.PlatformError, Scope.Scope> =
  Effect.gen(function* () {
    const { input, keys, output } = yield* Effect.acquireRelease(
      Effect.try({
        try: () => ({
          input: Fs.openSync("/dev/tty", Fs.constants.O_RDONLY | Fs.constants.O_NONBLOCK),
          // Only ever used to switch modes. It is never read from, so it never blocks.
          keys: new NodeTty.ReadStream(Fs.openSync("/dev/tty", "r")),
          output: new NodeTty.WriteStream(Fs.openSync("/dev/tty", "w")),
        }),
        catch: (cause) => platformError("open", cause),
      }),
      ({ input, keys, output }) =>
        Effect.sync(() => {
          Fs.closeSync(input);
          keys.destroy();
          output.destroy();
        }),
    );

    const readInput = Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      const bytes = new PassThrough();
      const readline = Readline.createInterface({ input: bytes, escapeCodeTimeout: 50 });
      const onKeypress = (text: string | undefined, key: Readline.Key) => {
        const parsed = {
          name: key.name ?? "",
          ctrl: !!key.ctrl,
          meta: !!key.meta,
          shift: !!key.shift,
        };
        Queue.offerUnsafe(queue, { input: Option.fromUndefinedOr(text), key: parsed });
        if (shouldQuit(parsed)) Queue.endUnsafe(queue);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Readline.emitKeypressEvents(bytes, readline);
          bytes.on("keypress", onKeypress);
          keys.setRawMode(true);
        }),
        () =>
          Effect.sync(() => {
            bytes.off("keypress", onKeypress);
            keys.setRawMode(false);
            readline.close();
            bytes.destroy();
          }),
      );

      const buffer = Buffer.alloc(256);
      const poll = Effect.sync(() => {
        try {
          const size = Fs.readSync(input, buffer);
          // No bytes without EAGAIN means the terminal has gone away.
          if (size === 0) Queue.endUnsafe(queue);
          else bytes.write(Buffer.from(buffer.subarray(0, size)));
          return size > 0;
        } catch (cause) {
          if (isWouldBlock(cause)) return true;
          Queue.endUnsafe(queue);
          return false;
        }
      });
      yield* poll.pipe(
        Effect.tap(() => Effect.sleep(KEY_POLL_INTERVAL)),
        Effect.repeat({ while: (open) => open }),
        Effect.forkScoped,
      );
      return queue as Queue.Dequeue<Terminal.UserInput, Cause.Done>;
    });

    return Terminal.make({
      columns: Effect.sync(() => output.columns ?? 0),
      rows: Effect.sync(() => output.rows ?? 0),
      // Prompts only read key input.
      readLine: Effect.die("Tty does not read lines"),
      readInput,
      display: (text) =>
        Effect.callback<void, PlatformError.PlatformError>((resume) => {
          output.write(text, (error) =>
            resume(error ? Effect.fail(platformError("display", error)) : Effect.void),
          );
        }).pipe(Effect.uninterruptible),
    });
  });
