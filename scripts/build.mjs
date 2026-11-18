import { build } from "esbuild";
import { buildNative } from "./native-build.mjs";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist/native", { recursive: true });
copyFileSync("native/windows.swift", "dist/native/windows.swift");
if (process.platform === "darwin") {
  const identity = {
    compiler: execFileSync("/usr/bin/swiftc", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    compilerPath: execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    sdk: execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    sdkVersion: execFileSync("/usr/bin/xcrun", ["--show-sdk-version"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    arch: process.arch,
    flags: ["-O"],
    environment: Object.fromEntries(
      [
        "DEVELOPER_DIR",
        "TOOLCHAINS",
        "SDKROOT",
        "MACOSX_DEPLOYMENT_TARGET",
      ].map((key) => [key, process.env[key] ?? ""]),
    ),
  };
  const result = buildNative({
    sourcePath: "native/windows.swift",
    outputPath: "dist/native/windows",
    identity,
    force: process.env.MCP_SCREENSHOT_REBUILD_NATIVE === "1",
    compile(output) {
      const cache = mkdtempSync(join(tmpdir(), "mcp-screenshot-build-"));
      try {
        execFileSync(
          "/usr/bin/swiftc",
          [
            "-O",
            "-module-cache-path",
            cache,
            "native/windows.swift",
            "-o",
            output,
          ],
          { stdio: "inherit", timeout: 120_000 },
        );
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
    },
  });
  console.log(`Native helper: ${result}.`);
}
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
chmodSync("dist/index.js", 0o755);
