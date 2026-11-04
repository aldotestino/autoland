import { Effect, Option, Stdio, Stream } from "effect";
import { Prompt } from "effect/cli";
import {
  type BatchOptions,
  BatchFailed,
  parsePrTokens,
  REPO_NAME,
  UsageError,
  uniqueSorted,
} from "./domain";
import { commandExists, exec } from "./exec";
import { GitHub, type RepoApi } from "./github";
import { processPr } from "./merge-pr";
import { picker, toEntries } from "./picker";
import { Tty } from "./tty";
import { Ui } from "./ui";

const usage = (message: string) => new UsageError({ message });

const preflight = Effect.gen(function* () {
  for (const tool of ["gh", "git"]) {
    if (!(yield* commandExists(tool))) return yield* usage(`Missing command: ${tool}`);
  }
  const toplevel = yield* exec("git", ["rev-parse", "--show-toplevel"]).pipe(
    Effect.mapError((cause) => usage(`Cannot run git: ${cause.message}`)),
  );
  if (toplevel.exitCode !== 0) return yield* usage("Run from a Git repository");

  const repo = yield* (yield* GitHub).currentRepo.pipe(
    Effect.mapError((error) =>
      usage(`Cannot identify repository; check gh auth status (${error.message})`),
    ),
  );
  if (!REPO_NAME.test(repo)) return yield* usage("Invalid repository name");
  return repo;
});

/** Positional PRs, or stdin when it is piped. Empty piped stdin still counts as a selection. */
const readInputs = Effect.fn("readInputs")(function* (inputs: ReadonlyArray<string>) {
  if (inputs.length > 0) return inputs;
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) return inputs;
  const piped = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError((cause) => usage(`Cannot read stdin: ${cause.message}`)),
  );
  return [piped];
});

/** Narrows `numbers` to the PRs with every label; all of them when none were listed. */
const applyLabelFilter = Effect.fn("applyLabelFilter")(function* (
  api: RepoApi,
  numbers: ReadonlyArray<number>,
  labels: ReadonlyArray<string>,
) {
  const ui = yield* Ui;
  const matches = yield* api
    .openPrsWithLabels(labels)
    .pipe(
      Effect.mapError((error) =>
        usage(`Cannot list PRs for the requested labels (${error.message})`),
      ),
    );
  if (numbers.length === 0) return matches;
  const matching = new Set(matches);
  const selected: Array<number> = [];
  for (const number of numbers) {
    if (matching.has(number)) selected.push(number);
    else yield* ui.log(`PR #${number}: excluded by label filters.`);
  }
  return selected;
});

/** Returns none when the user cancels or there is nothing to choose from. */
const pickPrs = Effect.fn("pickPrs")(function* (repo: string, api: RepoApi) {
  const ui = yield* Ui;
  const tty = yield* Tty;
  yield* ui.start("Loading open PRs");
  const pulls = yield* api.openNonDraftPulls.pipe(
    Effect.mapError((error) => usage(`Cannot list open PRs (${error.message})`)),
  );
  yield* ui.finish(true, "Open PRs loaded.");
  if (pulls.length === 0) {
    yield* ui.log(`No open non-draft PRs in ${repo}.`);
    return Option.none<ReadonlyArray<number>>();
  }
  const picked = yield* tty.prompt(picker(repo, toEntries(pulls)), { fullscreen: true });
  const numbers = Option.flatten(picked);
  if (Option.isNone(numbers)) yield* ui.log("Cancelled.");
  return numbers;
});

const printPlan = Effect.fn("printPlan")(function* (
  repo: string,
  prs: ReadonlyArray<number>,
  options: BatchOptions,
) {
  const ui = yield* Ui;
  yield* ui.log(`Repository: ${repo}\nMethod: ${options.method}`);
  yield* ui.log("Approval: approve as your gh account if no current approval exists.");
  if (options.labels.length > 0) {
    yield* ui.log(`Labels (all required): ${options.labels.join(",")}`);
  }
  yield* ui.log(`Order: ${prs.map((number) => `#${number}`).join(" ")}`);
});

export const runBatch = Effect.fn("runBatch")(
  function* (options: BatchOptions) {
    const ui = yield* Ui;
    const tty = yield* Tty;

    const repo = yield* preflight;
    const api = (yield* GitHub).forRepo(repo);
    const inputs = yield* readInputs(options.inputs);

    let numbers = yield* parsePrTokens(inputs, repo);

    if (options.labels.length > 0) {
      numbers = yield* applyLabelFilter(api, numbers, options.labels);
      if (numbers.length === 0) {
        yield* ui.log(`No matching open PRs for labels: ${options.labels.join(",")}`);
        return;
      }
    } else if (inputs.length === 0 && tty.available) {
      const picked = yield* pickPrs(repo, api);
      if (Option.isNone(picked)) return;
      numbers = picked.value;
    }
    if (numbers.length === 0) {
      return yield* usage("Supply at least one PR or --label filter (see --help)");
    }

    const prs = uniqueSorted(numbers);
    yield* printPlan(repo, prs, options);

    if (!options.dryRun && !options.yes) {
      const confirmed = yield* tty.prompt(
        Prompt.Confirm({ message: "Update, approve if needed, and merge this batch?" }),
      );
      if (Option.isNone(confirmed)) {
        return yield* usage("No terminal; use --non-interactive or --yes");
      }
      if (!confirmed.value) {
        yield* ui.log("Cancelled.");
        return;
      }
    }

    const unmerged: Array<number> = [];
    for (const number of prs) {
      yield* ui.log(`\n--- PR #${number} ---`);
      const outcome = yield* processPr(repo, number, options);
      const running = yield* ui.current;
      if (running !== "") yield* ui.finish(false, `${running} (failed).`);
      if (outcome === "stop") {
        yield* ui.log(`Batch stopped at PR #${number}.`);
        return yield* new BatchFailed();
      }
      if (outcome === "unmerged") unmerged.push(number);
    }

    if (unmerged.length > 0) {
      yield* ui.log(`\nUnmerged PRs: ${unmerged.map((number) => `#${number}`).join(" ")}`);
      return yield* new BatchFailed();
    }
    yield* ui.log("\nBatch complete.");
  },
  // Every way out stops the status line first, so its last state stays visible.
  Effect.catchTag("UsageError", (error) =>
    Effect.gen(function* () {
      const ui = yield* Ui;
      yield* ui.finish(false);
      yield* ui.error(`Error: ${error.message}`);
      return yield* error;
    }),
  ),
  Effect.onInterrupt(() =>
    Effect.gen(function* () {
      const ui = yield* Ui;
      const running = yield* ui.current;
      yield* ui.finish(false, `${running || "Batch"} (interrupted).`);
    }),
  ),
);
