import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ExecOptions {
  /**
   * Run in this process's session rather than a new one (the default for
   * spawned children). Anything that may talk to the terminal needs this: a
   * detached child has no controlling terminal, so `/dev/tty` cannot be opened
   * and, for example, ssh cannot ask for a passphrase.
   */
  readonly attached?: boolean;
}

const collect = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/** Runs a command to completion. A non-zero exit is a result, not a failure. */
export const exec = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        ...(options?.attached ? { detached: false } : {}),
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) } satisfies ExecResult;
  }).pipe(Effect.scoped);

/** Whether a command can be found on PATH, without running it. */
export const commandExists = (command: string) =>
  exec("sh", ["-c", 'command -v -- "$1"', "sh", command]).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );
