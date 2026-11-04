#!/usr/bin/env node
// The `autoland` command. npm installs only the optional dependency matching this
// platform, and this starts its compiled binary. Node is only needed for this file.
"use strict";
// This runs on plain Node before anything else, so Effect's rules cannot apply.
// oxlint-disable effecttsgo/global-console, effecttsgo/node-builtin-import

const { spawn } = require("node:child_process");

const name = `@aldotestino/autoland-${process.platform}-${process.arch}`;

let binary;
try {
  binary = require.resolve(`${name}/bin/autoland`);
} catch {
  console.error(
    `autoland: ${name} is not installed.\n` +
      "Supported platforms are macOS and glibc Linux, on arm64 and x64.\n" +
      "On a supported platform, reinstall without omitting optional dependencies.",
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Stay alive until the binary has cleaned up, so its exit status is the one reported.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(`autoland: cannot start ${binary}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
