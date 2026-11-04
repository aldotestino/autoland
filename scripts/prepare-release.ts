import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import root from "../package.json";
import { exec } from "../src/exec";
import { buildNpmPackages, platformDir } from "./build-npm";
import { PLATFORMS, platformPackageName } from "./npm-packages";

const isPublished = Effect.fn("isPublished")(function* (name: string) {
  const result = yield* exec("npm", ["view", `${name}@${root.version}`, "version"]);
  if (result.exitCode === 0) return result.stdout.trim() === root.version;
  if (result.stderr.includes("E404")) return false;
  // A network failure must not look like "not published yet".
  return yield* Effect.die(`Cannot check ${name} on npm:\n${result.stderr}`);
});

/**
 * Runs on every push to main with no pending changesets, so it must do nothing
 * unless a new version is due. `changeset publish` then publishes the launcher.
 *
 * The binaries go first: installing the launcher needs them, and a failure part
 * way through is fixed by running this again.
 */
const prepareRelease = Effect.gen(function* () {
  if (yield* isPublished(root.name)) {
    yield* Console.log(`${root.name}@${root.version} is already published.`);
    return;
  }

  yield* buildNpmPackages;

  for (const platform of PLATFORMS) {
    const name = platformPackageName(root, platform);
    if (yield* isPublished(name)) {
      yield* Console.log(`${name}@${root.version} is already published.`);
      continue;
    }
    yield* Console.log(`Publishing ${name}@${root.version}`);
    const result = yield* exec("npm", ["publish", platformDir(name), "--access", "public"]);
    if (result.exitCode !== 0) {
      return yield* Effect.die(`Cannot publish ${name}:\n${result.stdout}${result.stderr}`);
    }
  }
});

prepareRelease.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
