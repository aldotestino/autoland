/** What gets published to npm, generated from the root package.json at release time. */

export interface RootManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
}

export interface Platform {
  readonly os: "darwin" | "linux";
  readonly cpu: "arm64" | "x64";
  /** A `bun build --compile` target. Baseline x64 also runs on CPUs without AVX2. */
  readonly target: string;
}

export const PLATFORMS: ReadonlyArray<Platform> = [
  { os: "darwin", cpu: "arm64", target: "bun-darwin-arm64" },
  { os: "darwin", cpu: "x64", target: "bun-darwin-x64-baseline" },
  { os: "linux", cpu: "arm64", target: "bun-linux-arm64" },
  { os: "linux", cpu: "x64", target: "bun-linux-x64-baseline" },
];

export const platformPackageName = (root: Pick<RootManifest, "name">, platform: Platform) =>
  `${root.name}-${platform.os}-${platform.cpu}`;

const shared = (root: RootManifest) => ({
  version: root.version,
  license: root.license,
  // Trusted publishing requires this to match the GitHub repository exactly.
  repository: root.repository,
  homepage: root.homepage,
  bugs: root.bugs,
  publishConfig: { access: "public" },
});

export const platformManifest = (root: RootManifest, platform: Platform) => ({
  name: platformPackageName(root, platform),
  description: `The ${platform.os}-${platform.cpu} binary for ${root.name}.`,
  ...shared(root),
  os: [platform.os],
  cpu: [platform.cpu],
  // The Linux binaries are built against glibc and do not run on musl.
  ...(platform.os === "linux" ? { libc: ["glibc"] } : {}),
  files: ["bin"],
});

/** No code and no regular dependencies: only the launcher and the exact binaries it starts. */
export const launcherManifest = (root: RootManifest) => ({
  name: root.name,
  description: root.description,
  ...shared(root),
  bin: { autoland: "bin/autoland.cjs" },
  files: ["bin"],
  os: [...new Set(PLATFORMS.map((platform) => platform.os))],
  cpu: [...new Set(PLATFORMS.map((platform) => platform.cpu))],
  optionalDependencies: Object.fromEntries(
    PLATFORMS.map((platform) => [platformPackageName(root, platform), root.version]),
  ),
});
