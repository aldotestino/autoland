import { Schema } from "effect";
import { Argument, Flag } from "effect/cli";
import { MergeMethod } from "./domain";

const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((label: string) => !label.startsWith("--") || "Label must not be an option"),
  Schema.makeFilter(
    (label: string) => !label.includes(",") || "Pass each label with a separate --label option",
  ),
);

const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999 }));

/**
 * On when present, off by default. A plain `Flag.Boolean` takes a following
 * `1` or `0` as its own value, which would swallow a PR number. A value can
 * still be given with `=`, as in `--dry-run=false`.
 */
const Switch = (name: string) => Flag.Boolean(name).pipe(Flag.withOptionalValue("true"));

export const params = {
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
  dryRun: Switch("dry-run").pipe(
    Flag.withDescription("Read-only preview; no updates, merges, or repairs"),
    Flag.withDefault(false),
  ),
  yes: Switch("yes").pipe(
    Flag.withDescription("Skip the initial batch confirmation"),
    Flag.withDefault(false),
  ),
  nonInteractive: Switch("non-interactive").pipe(
    Flag.withDescription("Skip all prompts and leave conflicts unmerged"),
    Flag.withDefault(false),
  ),
};
