// oxlint-disable-next-line effecttsgo/node-builtin-import -- a sync read of a fixture.
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import root from "../package.json";
import {
  launcherManifest,
  PLATFORMS,
  platformManifest,
  platformPackageName,
} from "../scripts/npm-packages";

describe("published packages", () => {
  it.effect("the launcher depends on exactly this version of every binary", () =>
    Effect.sync(() => {
      const { optionalDependencies } = launcherManifest(root);
      assert.deepStrictEqual(optionalDependencies, {
        "@aldotestino/autoland-darwin-arm64": root.version,
        "@aldotestino/autoland-darwin-x64": root.version,
        "@aldotestino/autoland-linux-arm64": root.version,
        "@aldotestino/autoland-linux-x64": root.version,
      });
    }),
  );

  it.effect("the launcher ships no source and no regular dependencies", () =>
    Effect.sync(() => {
      const manifest = launcherManifest(root);
      assert.deepStrictEqual(manifest.files, ["bin"]);
      assert.deepStrictEqual(manifest.bin, { autoland: "bin/autoland.cjs" });
      assert.isFalse("dependencies" in manifest);
      assert.isFalse("scripts" in manifest);
      assert.isFalse("devDependencies" in manifest);
    }),
  );

  it.effect("the launcher looks for the same package names that are published", () =>
    Effect.sync(() => {
      const source = readFileSync("scripts/launcher.cjs", "utf8");
      assert.include(source, "`@aldotestino/autoland-${process.platform}-${process.arch}`");
      for (const platform of PLATFORMS) {
        assert.strictEqual(
          platformPackageName(root, platform),
          `@aldotestino/autoland-${platform.os}-${platform.cpu}`,
        );
      }
    }),
  );

  it.effect.each(PLATFORMS)("$os-$cpu installs only on its own platform", (platform) =>
    Effect.sync(() => {
      const manifest = platformManifest(root, platform);
      assert.deepStrictEqual(manifest.os, [platform.os]);
      assert.deepStrictEqual(manifest.cpu, [platform.cpu]);
      assert.deepStrictEqual(manifest.files, ["bin"]);
      assert.strictEqual(manifest.version, root.version);
      assert.isTrue(platform.target.startsWith(`bun-${platform.os}-${platform.cpu}`));
    }),
  );

  it.effect("trusted publishing can match every package to the repository", () =>
    Effect.sync(() => {
      const url = "git+https://github.com/aldotestino/autoland.git";
      assert.strictEqual(launcherManifest(root).repository.url, url);
      for (const platform of PLATFORMS) {
        assert.strictEqual(platformManifest(root, platform).repository.url, url);
      }
    }),
  );

  it.effect("Changesets publishes the generated launcher, not the repository root", () =>
    Effect.sync(() => {
      assert.strictEqual(root.publishConfig.directory, "dist/npm/autoland");
      assert.notProperty(root, "private");
    }),
  );
});
