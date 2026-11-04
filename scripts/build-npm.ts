import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path } from "effect";
import root from "../package.json";
import { exec } from "../src/exec";
import { launcherManifest, PLATFORMS, platformManifest, platformPackageName } from "./npm-packages";

export const OUT_DIR = "dist/npm";
const LAUNCHER_DIR = root.publishConfig.directory;

export const platformDir = (name: string) => `${OUT_DIR}/${name}`;

const run = Effect.fn("run")(function* (command: string, args: ReadonlyArray<string>) {
  const result = yield* exec(command, args);
  if (result.exitCode !== 0) {
    return yield* Effect.die(
      `${command} ${args.join(" ")} exited with ${result.exitCode}:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
});

/** Generates every package to publish under `dist/npm`. Nothing is published here. */
export const buildNpmPackages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writeManifest = (dir: string, manifest: unknown) =>
    fs.writeFileString(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  yield* fs.remove(OUT_DIR, { recursive: true, force: true });

  for (const platform of PLATFORMS) {
    const dir = platformDir(platformPackageName(root, platform));
    const binary = path.join(dir, "bin/autoland");
    yield* Console.log(`Compiling ${platform.target}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* run("bun", [
      "build",
      "src/cli.ts",
      "--compile",
      `--target=${platform.target}`,
      `--outfile=${binary}`,
    ]);
    yield* fs.chmod(binary, 0o755);
    yield* fs.copyFile("LICENSE", path.join(dir, "LICENSE"));
    yield* writeManifest(dir, platformManifest(root, platform));

    // Publishing a binary that cannot start is the one failure no later step would catch.
    if (platform.os === process.platform && platform.cpu === process.arch) {
      const output = yield* run(binary, ["--version"]);
      if (!output.includes(root.version)) {
        return yield* Effect.die(`${binary} --version printed: ${output}`);
      }
      yield* Console.log(`Smoke test passed: ${output.trim()}`);
    }
  }

  const launcher = path.join(LAUNCHER_DIR, "bin/autoland.cjs");
  yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
  yield* fs.copyFile("scripts/launcher.cjs", launcher);
  yield* fs.chmod(launcher, 0o755);
  yield* fs.copyFile("LICENSE", path.join(LAUNCHER_DIR, "LICENSE"));
  yield* fs.copyFile("README.md", path.join(LAUNCHER_DIR, "README.md"));
  yield* writeManifest(LAUNCHER_DIR, launcherManifest(root));
});

if (import.meta.main) {
  buildNpmPackages.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
}
